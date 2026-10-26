---
name: CADDi
colors:
  primary: '#224bd2'
  primary-deep: '#0d34b5'
  foreground: '#1f2533'
  text-secondary: '#606985'
  text-tertiary: '#374059'
  border: '#d5d7e0'
  surface: '#f4f5f8'
  canvas: '#ffffff'
  status-error: '#ff4e57'
  status-success: '#2ec7cc'
  status-warning: '#e9c212'
typography:
  xs:
    fontSize: 12px
    use: '--font-size-xs'
  s:
    fontSize: 14px
    use: '--font-size-s; the button label size'
  m:
    fontSize: 16px
    use: '--font-size-m; the most common rendered size, on 78 elements'
  l:
    fontSize: 20px
    use: '--font-size-l'
  xl:
    fontSize: 24px
    use: '--font-size-xl'
  xxl:
    fontSize: 32px
    use: '--font-size-2xl'
  xxxl:
    fontSize: 40px
    use: '--font-size-3xl'
  display:
    fontSize: 48px
    use: '--font-size-4xl; the largest published step'
rounded:
  s: 4px
  m: 6px
  l: 8px
  full: 200px
spacing:
  s2: 2
  s4: 4
  s6: 6
  s8: 8
  s12: 12
  s16: 16
  s20: 20
  s24: 24
  s32: 32
  s40: 40
  s48: 48
  s56: 56
  s64: 64
  s80: 80
  s96: 96
  s120: 120
  s160: 160
components:
  button-primary:
    type: button
    backgroundColor: '#1f2533'
    textColor: '#ffffff'
    border: 1px solid transparent
    rounded: 0px
    height: 48px
    padding: 16px 20px
    typography: 14px / 500
    hover: '#f4f5f8'
    pressed: '#f4f5f8'
    focus: '#224bd2'
    use: 'The filled action — square, 48px, and it inverts completely on hover: #f4f5f8 fill with #1f2533 text and border. Focus draws a #224bd2 2px solid outline.'
  select-language:
    type: input
    backgroundColor: '#f4f5f8'
    textColor: '#1f2533'
    border: '1px solid #d5d7e0'
    rounded: 0px
    height: 43px
    padding: 0 12px
    typography: 16px / 500
    hover: '#1f2533'
    pressed: '#1f2533'
    focus: '#224bd2'
    use: 'The language select in the header, 160×43 — the mirror of the primary button: it inverts the other way, from the pale surface to the dark ink.'
  button-contact:
    type: button
    backgroundColor: transparent
    textColor: '#224bd2'
    rounded: 0px
    height: 47px
    padding: 16px 20px
    typography: 16px / 400
    hover: '#224bd2'
    pressed: '#224bd2'
    use: 'お問い合わせ — transparent with primary-blue text, filling with #224bd2 on hover and pressed. Its focus renders the browser''s own ring, unlike the two above, so none is recorded.'
fonts:
  roles:
    sans: NB International Pro
    japanese: MFW-PIshiiGothicStdN
    mono: JetBrains Mono
---

# CADDi

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to CADDi; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/caddi/DESIGN.md

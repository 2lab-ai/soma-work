---
name: Hatena
colors:
  primary: '#00a0f0'
  primary-dark: '#0086d6'
  primary-light: '#1abaff'
  foreground: '#111111'
  text-token: '#121212'
  text-muted: '#999999'
  text-secondary: '#666666'
  surface: '#eaeaea'
  surface-pressed: '#cccccc'
  canvas: '#ffffff'
  attention: '#ff2d32'
  users: '#ff4166'
  service-bookmark: '#00a6e4'
  service-blog: '#2f2f2f'
  service-question: '#009cbc'
  service-anond: '#4d77f0'
  service-parks: '#14aa50'
  star-yellow: '#ffb400'
  star-green: '#00d300'
  star-red: '#ff003e'
  star-blue: '#00a1de'
  star-purple: '#b400c0'
  dark-bg: '#181818'
  dark-divider: '#282828'
  dark-border: '#333333'
typography:
  f11:
    fontSize: 11px
    use: '--size-font-11'
  f12:
    fontSize: 12px
    use: '--size-font-12; service links'
  f13:
    fontSize: 13px
    use: '--size-font-13'
  f14:
    fontSize: 14px
    use: '--size-font-14; buttons, the search field and entry titles'
  f15:
    fontSize: 15px
    use: '--size-font-15'
  f16:
    fontSize: 16px
    use: '--size-font-16'
  f17:
    fontSize: 17px
    use: '--size-font-17'
  f18:
    fontSize: 18px
    use: '--size-font-18'
  f19:
    fontSize: 19px
    use: '--size-font-19'
  f20:
    fontSize: 20px
    use: '--size-font-20'
  f24:
    fontSize: 24px
    use: '--size-font-24, the largest step'
rounded:
  xs: 2px
  s: 4px
  m: 8px
  l: 16px
components:
  button-signup:
    type: button
    backgroundColor: '#00a0f0'
    textColor: '#ffffff'
    rounded: 4px
    height: 32px
    padding: 8px 16px
    typography: 14px / 700
    hover: '#00a0f0'
    pressed: '#00a0f0'
    use: はてなIDを作る(無料) in the header — --color-service-portal as a fill (.Header.signup). Hover and press change nothing; focus is the browser's ring.
  button-signin:
    type: button
    backgroundColor: transparent
    textColor: '#00a0f0'
    rounded: 4px
    height: 32px
    padding: 8px 16px
    typography: 14px / 700
    hover: transparent
    pressed: transparent
    use: ログイン — the portal blue as a label (.Header.signin). No hover change.
  input-search:
    type: input
    backgroundColor: '#eaeaea'
    textColor: '#111111'
    rounded: 16px
    height: 32px
    padding: 0 32px 0 40px
    typography: 14px / 400
    pressed: '#cccccc'
    focus: '#cccccc'
    use: 'The entry search field, a grey pill. It darkens to #cccccc when pressed and while focused — the one authored state on the page.'
  link-entry:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    height: 56px
    typography: 14px / 700
    hover: transparent
    pressed: transparent
    use: Entry titles in the feeds. No hover change; the browser's ring on focus.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# Hatena

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hatena; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/hatena/DESIGN.md

---
name: Nulab
colors:
  brand: '#7a6abf'
  brand-hover: '#6e5fac'
  brand-pressed: '#625599'
  brand-disabled: '#cbc2e8'
  default: '#74758b'
  default-hover: '#696a7d'
  outline: '#cbc2e8'
  backlog: '#319b77'
  backlog-mark: '#42ce9f'
  cacoo: '#4c7ebf'
  typetalk: '#f45748'
  nulabpass: '#775fed'
  flowbase: '#1faddb'
  ad: '#ffaa1d'
  foreground: '#17171c'
  text-secondary: '#5d5e6f'
  text-inactive: '#9e9eae'
  border: '#d5d5de'
  canvas: '#ffffff'
  surface: '#f5f5f7'
  beige: '#f8f3f0'
  success: '#00bd7b'
  alert: '#ff6455'
  error: '#e50000'
typography:
  small:
    fontSize: 12px
    use: The smallest rendered step on the corporate surface
  body:
    fontSize: 14px
    use: The dominant size — 51 of 119 text elements
  base:
    fontSize: 16px
    use: Lead paragraphs and the large product button
  lead:
    fontSize: 18px
    use: Section intros and the Backlog call-to-action text
  heading:
    fontSize: 24px
    use: Section headings
  display:
    fontSize: 46px
    use: The single largest step on the page
rounded:
  sm: 4px
  lg: 16px
  circle: 9999px
spacing:
  dp40: 40
  dp64: 64
  dp80: 80
  dp96: 96
  dp104: 104
  dp112: 112
  dp120: 120
  dp128: 128
  dp144: 144
  dp152: 152
  dp160: 160
components:
  button-default:
    type: button
    backgroundColor: '#74758b'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 14px 8px 38px
    typography: 16px / 700
    shadow: rgba(28,28,28,0.2) 0 2px 4px
    hover: '#696a7d'
    pressed: '#696a7d'
    focus: '#cbc2e8'
    use: 'Neutral product button (Backlogを詳しく見る), 247×56. Hover, pressed and focus all settle on #696a7d; focus adds a 4px #cbc2e8 outline.'
  button-nulab:
    type: button
    backgroundColor: '#7a6abf'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 24px
    typography: 14px / 600
    hover: '#6e5fac'
    pressed: '#6e5fac'
    focus: '#cbc2e8'
    use: Corporate purple action (同意する), 105×40 — the --button-nulab family rendered.
  link-settings:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#7a6abf'
    rounded: 4px
    padding: 8px 0
    typography: 14px / 600
    hover: '#ffffff'
    pressed: '#7a6abf'
    focus: '#cbc2e8'
    use: 'Quiet text action (クッキー設定), 85×40. Hover changes nothing; pressed removes the outline width; focus draws the 4px #cbc2e8 ring as a box-shadow instead of an outline.'
  backlog-button-primary:
    type: button
    backgroundColor: '#f27100'
    textColor: '#ffffff'
    border: 2px solid transparent
    rounded: 4px
    padding: 8px 14px
    typography: 14px / 700
    hover: '#bf5900'
    pressed: '#bf5900'
    focus: '#cbc2e8'
    use: Backlog's filled action (無料で試す), 102×40 — orange, not the green the corporate token set assigns to Backlog.
    height: 40px
  backlog-button-outlined:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#f27100'
    border: '2px solid #f27100'
    rounded: 4px
    padding: 8px 14px
    typography: 14px / 700
    hover: '#fff8f2'
    pressed: '#fff8f2'
    focus: '#cbc2e8'
    use: 'Backlog''s outlined twin (資料ダウンロード), 144×40. Hover fills with a #fff8f2 wash and darkens text and border to #bf5900 together.'
  backlog-cta-primary:
    type: button
    backgroundColor: '#f27100'
    textColor: '#ffffff'
    border: '2px solid #f27100'
    rounded: 4px
    padding: 10px 0
    typography: 18px / 700
    shadow: rgba(0,0,0,0.2) 0 2px 4px
    hover: '#bf5900'
    pressed: '#bf5900'
    focus: '#cbc2e8'
    use: Backlog's large conversion CTA, 305×70 — the same orange one step up in size and weight.
fonts:
  roles:
    sans: Noto Sans JP
---

# Nulab

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Nulab; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/nulab/DESIGN.md

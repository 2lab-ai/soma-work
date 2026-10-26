---
name: ABEMA
colors:
  primary: '#ddaa00'
  primary-hover: '#dfb015'
  accent: '#f0163a'
  accent-hover: '#f34461'
  green: '#16deb5'
  green-hover: '#44e5c5'
  purple: '#a873ff'
  purple-hover: '#af7eff'
  ppv-blue: '#02d1d6'
  coin: '#ffc400'
  canvas: '#000000'
  surface: '#171717'
  surface-sub: '#212121'
  surface-hover: '#373737'
  surface-deep: '#0b0b0b'
  skeleton: '#1c1c1c'
  foreground: '#e6e6e6'
  smoke: '#999999'
  smoke-strong: '#767676'
  link-hover: '#c5c5c5'
  hairline: '#333333'
  pale: '#f5f5f5'
  on-primary: '#212121'
  white: '#ffffff'
typography:
  title-l:
    fontSize: 32px
    fontWeight: 700
    use: Page titles (--font-size-title-l)
  title-m:
    fontSize: 27px
    fontWeight: 700
    use: Section titles (--font-size-title-m)
  title-s:
    fontSize: 22px
    fontWeight: 700
    use: Sub-section titles (--font-size-title-s)
  heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: Status/feature headings (SorryPage h1, --font-size-xxxl)
  body-lg:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Emphasis body, notification text (--font-size-l)
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, button labels (--font-size-m)
  caption:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.5
    use: Tags, badges, meta (--font-size-xs)
  micro:
    fontSize: 10px
    fontWeight: 700
    use: Thumbnail labels (--font-size-xxs)
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  xl: 12px
  full: 9999px
spacing:
  unit: 4
  sm: 8
  md: 12
  base: 16
  lg: 32
  content-min: 724
  content-max: 1024
  content-max-vod: 1280
components:
  button-primary:
    type: button
    backgroundColor: '#ddaa00'
    textColor: '#212121'
    rounded: 4px
    height: 44px
    typography: 14px / 700
    states: 'hover #dfb015 · active opacity .7 · disabled opacity .4'
    use: Primary CTA (com-a-Button--primary)
  button-secondary:
    type: button
    backgroundColor: '#e6e6e6'
    textColor: '#212121'
    rounded: 4px
    height: 44px
    typography: 14px / 700
    hover: '#ffffff'
    use: Secondary action
  button-dark:
    type: button
    backgroundColor: '#212121'
    textColor: '#e6e6e6'
    rounded: 4px
    height: 44px
    typography: 14px / 700
    hover: '#373737'
    use: Tertiary action on dark canvas
  button-danger:
    type: button
    backgroundColor: '#f0163a'
    textColor: '#ffffff'
    rounded: 4px
    height: 44px
    typography: 14px / 700
    hover: '#f34461'
    use: Destructive / cancel-subscription action
  badge-live:
    type: badge
    backgroundColor: '#f0163a'
    textColor: '#ffffff'
    rounded: 4px
    height: 20px
    padding: 0 4px
    typography: 12px / 700
    use: LIVE broadcasting tag on thumbnails (com-BroadcastingTag)
  input-text:
    type: input
    backgroundColor: '#212121'
    textColor: '#e6e6e6'
    rounded: 4px
    height: 44px
    typography: 14px / 400
    use: 'Dark text field; search variant 46px; placeholder #999999'
  card-floating:
    type: card
    backgroundColor: '#212121'
    rounded: 4px
    shadow: 0 2px 16px rgba(0,0,0,.2)
    use: Search-suggest panel / floating dropdown card
  tab-panel:
    type: tab
    active: 'bg #212121 + text #e6e6e6'
    rounded: 4px 4px 0 0
    height: 44px
    use: Content panel tabs (com-m-TabList)
  toggle-checkbox:
    type: toggle
    backgroundColor: '#ddaa00'
    border: '1px solid #999999'
    rounded: 2px
    height: 20px
    use: Checkbox; checked fills ABEMA yellow
  toast-notification:
    type: toast
    backgroundColor: '#212121'
    textColor: '#e6e6e6'
    rounded: 4px
    padding: 12px 16px
    typography: 16px / 700
    use: 'Notification block; leading label in #ddaa00'
fonts:
  roles:
    sans: CopyRight (custom webfont) + Hiragino Sans + BIZ UDPGothic
    alphanumeric: Helvetica / Arial
    condensed: Roboto Condensed
---

# ABEMA

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ABEMA; reproduced for educational reference. Full prose: https://oh-my-design.kr/abema/design.md

---
name: Cybozu
colors:
  primary: '#139cb7'
  primary-light: '#64bdd4'
  ink: '#333333'
  ink-pure: '#000000'
  muted: '#aaaaaa'
  muted-slate: '#838d94'
  slate-dark: '#31424e'
  slate-darker: '#465560'
  canvas: '#ffffff'
  surface: '#f6f6f6'
  hairline: '#e6e6e6'
  on-primary: '#ffffff'
  kintone-yellow: '#ffbf00'
  kintone-amber: '#ffdb4f'
  kintone-amber-deep: '#ff8f00'
  kintone-ink: '#231200'
  kintone-surface: '#f3f3f3'
  kintone-tint: '#fff5e1'
  kintone-card-border: '#d6d5d5'
  kintone-dark: '#333333'
typography:
  corp-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 2
    use: Corporate body text, Hiragino, 32px line-height
  corp-nav:
    fontSize: 14px
    fontWeight: 700
    use: Corporate nav links, bold Hiragino
  corp-en-label:
    fontSize: 16px
    fontWeight: 400
    use: 'English section labels in muted grey #aaaaaa'
  kintone-h2:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: 2.6px
    use: kintone section heads, Roboto + Noto Sans JP, positive tracking
  kintone-h2-alt:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.96px
    use: kintone secondary heads
  kintone-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.69
    use: kintone body text, 27px line-height
  chip:
    fontSize: 12px
    fontWeight: 700
    use: kintone yellow badge chips
rounded:
  sm: 4px
  md: 8px
  lg: 10px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 62
components:
  corp-nav-link:
    type: tab
    textColor: '#333333'
    typography: 14px / 700 Hiragino
    active: 'teal #139cb7 text on hover/active'
    use: Corporate top-nav item
  corp-text-link:
    type: button
    textColor: '#139cb7'
    typography: 16px / 400 Hiragino
    hover: '#139cb7'
    pressed: '#139cb7'
    focus: '#2693ff'
    use: 'Corporate inline / list text link — the single teal action color. Hover and pressed leave it unchanged; focus recolours the text to #2693ff.'
  corp-icon-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#139cb7'
    rounded: 9999px
    shadow: rgba(0,0,0,0.1) 0 0 6px
    hover: rgba(0,0,0,0.2) 0 0 2px
    pressed: rgba(0,0,0,0.2) 0 0 2px
    focus: '#2693ff'
    use: Circular icon button, soft shadow, 40px. Hover and pressed tighten the shadow and drop it 2px — it presses into the page rather than lifting off it.
  corp-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e6e6e6'
    use: 'Corporate content card, hairline-separated on #f6f6f6 surface'
  kintone-cta-dark:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 8px
    padding: 5px 5px 5px 20px
    height: 64px
    typography: 16px / 400 Roboto
    hover: '#333333'
    pressed: '#ffbf00'
    focus: '#ffbf00'
    use: kintone primary CTA (30日間無料お試し) — dark fill with yellow accent. Hover changes nothing; pressed and focus draw the kintone yellow as the outline colour.
  kintone-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#231200'
    border: '1px solid #d6d5d5'
    rounded: 8px
    padding: 5px 5px 5px 20px
    height: 66px
    hover: '#ffffff'
    pressed: '#ffbf00'
    focus: '#ffbf00'
    use: kintone secondary outlined button — the same yellow outline on pressed and focus as the dark CTA, and the same unchanged hover.
  kintone-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#231200'
    border: '1px solid #d6d5d5'
    rounded: 10px
    padding: 24px
    use: kintone feature card, flat (no shadow)
  kintone-badge:
    type: badge
    backgroundColor: '#ffbf00'
    textColor: '#231200'
    rounded: 8px
    padding: 5px 8px 10px
    typography: 12px / 700
    use: kintone yellow tab/banner chip (さわってみよう！, 30日間無料！)
fonts:
  roles:
    corporate: Hiragino Kaku Gothic Pro
    product: Roboto / Noto Sans JP
    fallback: Meiryo
---

# Cybozu

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cybozu; reproduced for educational reference. Full prose: https://oh-my-design.kr/cybozu/design.md

---
name: ING
colors:
  brand: '#ff6200'
  primary: '#525199'
  secondary-bold: '#31305b'
  secondary-subtle: '#dcdceb'
  tertiary: '#ab0066'
  foreground: '#333333'
  text-subtle: '#696969'
  canvas: '#ffffff'
  page: '#f0f0f0'
  hover-primary: '#cfe4f4'
  hover-tertiary: '#eecce0'
  highlight: '#dfedf8'
  focus: '#335d7d'
  info: '#559bd1'
  success: '#349651'
  error: '#d70000'
typography:
  button:
    fontSize: 16px
    fontWeight: 700
    use: header buttons
rounded:
  sm: 8px
components:
  button-primary:
    type: button
    backgroundColor: '#525199'
    textColor: '#ffffff'
    rounded: 8px
    height: 36px
    typography: 16px / 700
    hover: layer rgba(255,255,255,0.08)
    pressed: 'layer rgba(255,255,255,0.16) + inset ring 2px #ffffff'
    focus: 'outline 2px solid #335d7d + inset 2px #ffffff'
    use: Open een rekening — indigo --bg_secondary; hover lays an 8% white layer, press a 16% layer and a white inner ring; focus a 2px navy-teal outline with the white inner ring.
    padding: 6px 12px
  link-login:
    type: button
    backgroundColor: transparent
    textColor: '#525199'
    border: '#525199'
    rounded: 8px
    height: 36px
    padding: 4px 10px
    typography: 16px / 700
    hover: '#525199 + layer rgba(0,0,0,0.08)'
    pressed: 'layer rgba(255,255,255,0.16) + inset ring 2px #ffffff'
    focus: 'outline 2px solid #335d7d + inset 2px #ffffff'
    use: Inloggen — an indigo text button that fills indigo with a white label on hover (plus an 8% dark layer).
  nav-menu:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 8px
    height: 28px
    hover: '#ffffff + layer rgba(0,0,0,0.08)'
    pressed: layer rgba(0,0,0,0.3)
    focus: 'outline 2px solid #335d7d'
    use: Producten, Voor wie, Thema's — menu buttons that gain an 8% dark layer on hover and 30% when pressed.
  link-quick:
    type: button
    backgroundColor: transparent
    textColor: '#525199'
    rounded: 0px
    height: 24px
    hover: '#cfe4f4'
    pressed: rgba(0,0,0,0.16)
    focus: 'outline 2px solid #335d7d'
    use: 'Klant worden, App activeren — indigo quick links that fill --bg_hover-primary #cfe4f4 on hover.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: INGMe
    display: ING Display
---

# ING

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ING; reproduced for educational reference. Full prose: https://oh-my-design.kr/ing/design.md

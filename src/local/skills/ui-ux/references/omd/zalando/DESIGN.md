---
name: Zalando
colors:
  brand: '#ff4c00'
  primary: '#000000'
  foreground: '#000000'
  canvas: '#ffffff'
  interactive: '#6328e0'
  negative: '#da0410'
  positive: '#00875a'
  hover: '#d2d8dd'
  pressed: '#b9c0c6'
  tertiary: '#f1f1f1'
  secondary: '#5c6169'
  border-secondary: '#d2d8dd'
  legacy-hover: '#efeff0'
  legacy-pressed: '#d0d1d3'
  legacy-secondary: '#66676e'
  legacy-red: '#d9000c'
  legacy-blue: '#0d6dff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: '--typography-body, 1rem/1.5rem'
  h1:
    fontSize: 40px
    fontWeight: 700
    use: '--typography-h1, 2.5rem/3rem'
  jumbo1:
    fontSize: 72px
    fontWeight: 700
    use: '--typography-jumbo1, 4.5rem/5.25rem, the largest step'
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  pill: 9984px
components:
  nav-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 9984px
    height: 36px
    padding: 6px 18px
    typography: 16px / 400
    hover: '#f1f1f1'
    pressed: '#f1f1f1'
    use: Damen, Herren, Kinder at the top of zalando.de — a white pill that greys to --color-background-tertiary on hover and press. Focus is the browser's ring.
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 9984px
    height: 48px
    padding: 12px 24px
    typography: 16px / 400
    hover: '#d2d8dd'
    pressed: '#b9c0c6'
    focus: rgba(0,0,0,0.3)
    use: A black pill with a 1px inset ring (the newsletter confirmation on the home page). Hover turns it light grey with a black label, press a shade darker, focus a 30% black wash — --color-background-focus — with no outline drawn.
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    height: 40px
    padding: 10px 12px 10px 0
    typography: 16px / 400
    hover: transparent
    focus: transparent
    use: The header search field (Suche). None of its measured values change on hover or focus.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: ZalandoSans
---

# Zalando

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zalando; reproduced for educational reference. Full prose: https://oh-my-design.kr/zalando/design.md

---
name: FlixBus
colors:
  brand: '#97d700'
  foreground: '#353535'
  ui-primary: '#31a100'
  ui-primary-light: '#5cc500'
  ui-primary-dark: '#187d00'
  highlight: '#e5f9c0'
  link: '#0047de'
  neutral: '#016ae7'
  content-secondary: '#646464'
  grayscale-90: '#444444'
  icon-primary: '#848484'
  line: '#c8c8c8'
  grayscale-30: '#e1e1e1'
  bg-secondary: '#f7f7f7'
  canvas: '#ffffff'
  success: '#228f00'
  warning: '#ff5704'
  danger: '#dd2828'
  ai: '#e100e1'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: '--flix-font-size-primary 1rem, line height 1.5rem'
  h1:
    fontSize: 27.2px
    fontWeight: 700
    use: '--flix-font-size-h1 1.7rem'
  button:
    fontSize: 16px
    fontWeight: 500
    use: buttons and navigation, --flix-font-weight-semibold 500
rounded:
  half: 3px
  sm: 6px
  md: 12px
components:
  button-search:
    type: button
    backgroundColor: '#97d700'
    textColor: '#353535'
    border: '#97d700'
    rounded: 6px
    height: 36px
    padding: 5px 12px
    typography: 16px / 500
    hover: layer rgba(0,0,0,0.06)
    pressed: layer rgba(0,0,0,0.12)
    focus: 'box-shadow 0 0 0 4px #ffffff + outline 2px solid #016ae7'
    use: Suchen, the search button. Hover lays --flix-hover-layer-color, a 6% black gradient, over the lime; press lays the 12% --flix-pressed-layer-color. Focus is a white halo inside a blue outline (--flix-focus-outline-color).
  nav-link:
    type: button
    backgroundColor: transparent
    textColor: '#353535'
    rounded: 6px
    height: 36px
    padding: 6px 12px
    typography: 16px / 500
    hover: layer rgba(0,0,0,0.06)
    pressed: layer rgba(0,0,0,0.12)
    focus: 'box-shadow 0 0 0 4px #ffffff + outline 2px solid #016ae7'
    use: Plane Deine Reise and Hilfe in the header — the same hover and press layers over a transparent ground, and the same focus ring.
  input-destination:
    type: input
    backgroundColor: transparent
    textColor: '#353535'
    rounded: 0px
    height: 24px
    typography: 16px / 400
    focus: transparent
    use: The destination field in the search form. Focus changes none of its measured values; the field's frame sits on a wrapper that was not read.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Roboto
---

# FlixBus

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to FlixBus; reproduced for educational reference. Full prose: https://oh-my-design.kr/flixbus/design.md

---
name: Citymapper
colors:
  primary: '#37ab2f'
  primary-hover: '#2e9127'
  green-light: '#53cb4b'
  green-dark: '#24711f'
  bright-green: '#2dc922'
  foreground: '#383838'
  text-secondary: '#4a4a4a'
  grey-70: '#666666'
  grey-50: '#8b8b8b'
  grey-20: '#cbcbcb'
  grey-10: '#e8e8e8'
  surface: '#f6f6f6'
  canvas: '#ffffff'
  night: '#090512'
  shade: '#001122'
  blue: '#417193'
  blue-deep: '#002f50'
  bright-blue: '#1e8aff'
  bright-blue-light: '#e9f3ff'
  orange: '#fe9001'
  yellow: '#f5c402'
  red: '#d22020'
  purple: '#895a93'
typography:
  label:
    fontSize: 14px
    use: the Get Me Somewhere button, 700
  body:
    fontSize: 16px
    use: body text, the search field and the city switcher
  store:
    fontSize: 20px
    use: the app-store buttons, 700
  action:
    fontSize: 24px
    use: the Go button, 700
rounded:
  sm: 4px
  md: 8px
  lg: 20px
  pill: 96px
components:
  button-cta:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    height: 38px
    padding: 4px 8px
    typography: 14px / 700
    hover: '#333333'
    pressed: '#333333, opacity 0.7'
    focus: 'outline 2px solid #000000, bg #333333'
    use: 'Get Me Somewhere in the header — the right half of a joined pair, rounded 0 4px 4px 0. Hover lifts to #333333; press also fades to 0.7; focus draws a solid black ring.'
  button-go:
    type: button
    backgroundColor: '#37ab2e'
    textColor: '#ffffff'
    rounded: 96px
    height: 52px
    padding: 14px 30px
    typography: 24px / 700
    hover: '#2e9127'
    pressed: '#2e9127'
    focus: 'outline 2px solid #000000'
    use: Go, beside the journey fields — the key green as a pill, darkening on hover. Rendered one channel off the --color-key and --color-green-60 tokens.
  button-store:
    type: button
    backgroundColor: '#090512'
    textColor: '#ffffff'
    rounded: 80px
    height: 48px
    padding: 12px
    typography: 20px / 700
    shadow: rgba(0,17,34,0) 0 0 0 0
    hover: scale 1.04, shadow rgba(0,17,34,0.2) 0 12px 28px
    pressed: scale 1.04, shadow rgba(0,17,34,0.2) 0 12px 28px
    focus: outline 3px solid rgba(30,138,255,0.6)
    use: iPhone and Android on the hero, one shared style. Hover lifts the button — it scales to 1.04 and gains a long shadow tinted with --color-shade. The only controls whose focus ring uses --color-focus.
  pill-city:
    type: button
    backgroundColor: rgba(255,255,255,0.1)
    textColor: '#ffffff'
    rounded: 64px
    height: 35px
    padding: 9px 20px 8px
    typography: 16px / 700
    hover: rgba(255,255,255,0.2)
    pressed: rgba(255,255,255,0.2)
    focus: outline 3px solid rgba(255,255,255,0.5)
    use: Switch City on the dark header — a translucent white pill that doubles its fill on hover, with a translucent white focus ring.
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#4a4a4a'
    rounded: 5px
    height: 38px
    padding: 8px 0 8px 8px
    typography: 16px / 400
    hover: transparent
    focus: transparent
    use: The start-location field (labelled only by aria-label). Nothing visible changes on hover or keyboard focus — its outline colour changes but its outline style stays none, so no ring is drawn.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Proxima Soft
---

# Citymapper

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Citymapper; reproduced for educational reference. Full prose: https://oh-my-design.kr/citymapper/design.md

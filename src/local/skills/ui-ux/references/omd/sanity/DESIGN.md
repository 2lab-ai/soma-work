---
name: Sanity
colors:
  brand-srgb-approx: '#ff5500'
  canvas: '#ffffff'
  foreground: '#0b0b0b'
  surface: '#212121'
  surface-subtle: '#ededed'
  on-dark: '#ffffff'
  muted: '#b9b9b9'
  divider: '#d6d6d6'
  focus-blue: '#0052ef'
typography:
  display-hero:
    fontSize: 112px
    fontWeight: 400
    lineHeight: 112
    letterSpacing: '-4.48px'
    use: Home H1
  section:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 51.84
    letterSpacing: '-1.68px'
    use: Home section heading
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 22.5
    letterSpacing: '-0.15px'
    use: Repeated body and input text
  control:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 16.9
    use: Compact action labels
rounded:
  input: 3px
  control: 99999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 24
  xl: 32
components:
  button-brand:
    type: button
    textColor: '#0b0b0b'
    rounded: 99999px
    padding: 4px 12px
    typography: 13px/400 IBM Plex Mono-eea356736565d76d
    hover: near-black fill with P3-orange text
    use: P3 orange pill; home + pricing surfaces
    pressed: '#b9b9b9'
  button-inverse:
    type: button
    backgroundColor: '#0b0b0b'
    textColor: '#ffffff'
    rounded: 99999px
    padding: 4px 12px
    typography: 13px/400 IBM Plex Mono-eea356736565d76d
    hover: near-black fill with white text
    use: Compact inverse pill
    pressed: '#ededed'
  button-light:
    type: button
    backgroundColor: '#ededed'
    textColor: '#0b0b0b'
    rounded: 99999px
    padding: 4px 12px
    typography: 13px/400 IBM Plex Mono-eea356736565d76d
    hover: light-gray fill with near-black text
    pressed: light-gray fill with near-black text
    use: Compact light pill
  input-text:
    type: input
    backgroundColor: '#0b0b0b'
    textColor: '#b9b9b9'
    rounded: 3px
    padding: 8px 12px
    typography: 15px/400 Waldenburg-75357948a2b6a39b
    focus: 'P3-orange border, #212121 fill, white text'
    use: Home textarea
fonts:
  roles:
    sans: Waldenburg-75357948a2b6a39b
    mono: IBM Plex Mono-eea356736565d76d
---

# Sanity

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sanity; reproduced for educational reference. Full prose: https://oh-my-design.kr/sanity/design.md

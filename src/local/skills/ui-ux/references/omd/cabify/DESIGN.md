---
name: Cabify
colors:
  primary: '#7145d6'
  primary-hover: '#8a6ee4'
  ring: '#a697ed'
  aubergine: '#1f123f'
  aubergine-hover: '#362065'
  foreground: '#1a1a1c'
  text-secondary: '#5e6088'
  surface: '#f2f2fd'
  surface-hover: '#dddaf9'
  subdued: '#f8f8fe'
  border: '#dbdce8'
  border-hover: '#c0c2d8'
  canvas: '#ffffff'
typography:
  button:
    fontSize: 14px
    fontWeight: 700
    use: 40px button
  button-large:
    fontSize: 18px
    fontWeight: 700
    use: 50px button
rounded:
  md: 8px
components:
  button-primary:
    type: button
    backgroundColor: '#7145d6'
    textColor: '#ffffff'
    rounded: 8px
    height: 40px
    typography: 14px / 700
    hover: '#8a6ee4'
    pressed: 'box-shadow 0 0 0 2px #a697ed'
    use: 'Regístrate in the header — --cta-primary-bg-color, lifting to --cta-primary-bg-color-hover #8a6ee4; press adds a 2px lavender ring. Focus is the browser''s ring.'
    padding: 0px 12px
  button-dark:
    type: button
    backgroundColor: '#1f123f'
    textColor: '#ffffff'
    rounded: 8px
    height: 50px
    typography: 18px / 700
    hover: '#362065'
    pressed: 'box-shadow 0 0 0 2px #8a6ee4'
    use: 'Conduce con nosotros — deep aubergine, lifting to #362065 on hover; press adds a 2px purple ring.'
  link-header:
    type: button
    backgroundColor: transparent
    textColor: '#5e6088'
    rounded: 8px
    height: 40px
    typography: 14px / 450
    hover: 'fg #7145d6'
    pressed: 'fg #7145d6'
    use: 'The language switch (ES) — grey #5e6088 that turns Cabify purple on hover and press.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Cabify Ciudad
    sans: Cabify Ciudad Text
---

# Cabify

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cabify; reproduced for educational reference. Full prose: https://oh-my-design.kr/cabify/design.md

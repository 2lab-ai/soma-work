---
name: Pennylane
colors:
  primary: '#003d3d'
  foreground: '#003d3d'
  accent: '#00f872'
  accent-soft: '#94ffb4'
  green-100: '#dafbf2'
  green-300: '#8ecec2'
  green-500: '#42ad9a'
  green-700: '#338585'
  green-800: '#0f5757'
  beige: '#f8f4f1'
  canvas: '#ffffff'
  salmon: '#ffa37b'
  yellow: '#f3c628'
  orange: '#ffc063'
  blue: '#358ddd'
  red: '#c11111'
  grey: '#7b7b7b'
typography:
  button:
    fontSize: 14px
    fontWeight: 700
    use: header call to action
  nav:
    fontSize: 16px
    fontWeight: 500
    use: header menu
rounded:
  sm: 4px
  md: 6px
components:
  button-primary:
    type: button
    backgroundColor: '#003d3d'
    textColor: '#ffffff'
    border: '#003d3d'
    rounded: 4px
    height: 38px
    padding: 8px 16px
    typography: 14px / 700
    hover: translateY(-2px) + shadow rgba(0,0,0,0.25) 0 4px 4px
    pressed: translateY(-2px) + shadow rgba(0,0,0,0.25) 0 4px 4px
    use: Démarrer maintenant in the header — teal --color-pennylane; on hover and press it rises 2px and casts a soft shadow, keeping its colour. Focus is the browser's ring.
  nav-menu:
    type: button
    backgroundColor: transparent
    textColor: '#003d3d'
    rounded: 0px
    height: 24px
    typography: 16px / 500
    hover: transparent
    use: Produit, Activité, Tarifs, Ressources — teal menu buttons with no hover, press or focus change on the button itself.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Manrope
---

# Pennylane

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Pennylane; reproduced for educational reference. Full prose: https://oh-my-design.kr/pennylane/design.md

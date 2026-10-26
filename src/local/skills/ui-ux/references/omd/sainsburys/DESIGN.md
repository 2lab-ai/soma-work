---
name: Sainsbury's
colors:
  primary: '#f06c00'
  primary-highlight: '#e55000'
  primary-light: '#ff9900'
  primary-surface: '#fef5f0'
  brand-2: '#7f0442'
  brand-2-dark: '#57002b'
  brand-2-light: '#a50052'
  foreground: '#404040'
  text-darker: '#262626'
  text-medium: '#737373'
  grey: '#8c8c8c'
  line: '#d8d8d8'
  surface: '#f2f2f2'
  canvas: '#ffffff'
  focus-blue: '#1976d2'
  blue-light: '#e8f1fb'
  green: '#2e7d32'
  red: '#d50000'
  yellow: '#ffd600'
typography:
  body-1:
    fontSize: 16px
    use: '--ln-font-stack-body-1 (Arial stack), 400'
  button:
    fontSize: 16px
    use: the rendered call to action, MaryAnn 800 (--ln-font-stack-button declares 1.125rem)
  body-2:
    fontSize: 18px
    use: '--ln-font-stack-body-2 (Arial stack), 400'
  nav:
    fontSize: 20px
    use: top navigation, MaryAnn 700
rounded:
  sm: 2px
  md: 4px
  pill: 20px
components:
  button-primary:
    type: button
    backgroundColor: '#f06c00'
    textColor: '#ffffff'
    rounded: 2px
    height: 47px
    padding: 12px 16px 13px
    typography: 16px / 800
    hover: '#f06c00'
    pressed: '#f06c00'
    focus: ring 0 0 0 3px rgba(25,118,210,0.7), bg rgba(229,80,0,0.8)
    use: Book a slot and Register — the orange call to action in MaryAnn ExtraBold. Hover changes nothing (with :hover confirmed). Focus draws the Luna focus ring, 3px of translucent blue, and deepens the fill toward --ln-color-palette-brand-1-highlight.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#404040'
    height: 52px
    padding: 11px 16px
    typography: 20px / 700
    hover: 'fg #e55000'
    pressed: 'fg #e55000'
    focus: 'fg #e55000, ring 0 0 0 3px rgba(25,118,210,0.7)'
    use: Top navigation (Groceries and siblings) in MaryAnn. The label turns the orange highlight on hover and focus; focus adds the blue ring.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: MaryAnn
---

# Sainsbury's

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sainsbury's; reproduced for educational reference. Full prose: https://oh-my-design.kr/sainsburys/design.md

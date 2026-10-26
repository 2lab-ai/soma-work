---
name: Composio
colors:
  primary: '#0007cd'
  brand: '#0007cd'
  accent-cyan: '#00ffff'
  accent-signal: '#0089ff'
  accent-ocean: '#0096ff'
  canvas: '#0f0f0f'
  surface: '#000000'
  hairline: '#2c2c2c'
  foreground: '#ffffff'
  muted: '#444444'
  on-primary: '#ffffff'
  light-border: '#e0e0e0'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 400
    lineHeight: 0.87
    use: Massive compressed hero headings
  section:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 1
    use: Major feature section titles
  subheading-lg:
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1
    use: Secondary section markers
  subheading:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.2
    use: Card titles, feature names
  card-title:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.2
    use: Medium-emphasis card headings
  feature-label:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.2
    use: Smaller card titles, labels
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.2
    use: Intro paragraphs
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body text, nav links, buttons
  body-sm:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.63
    use: Longer-form body text
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.63
    use: Descriptions, metadata
  label:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.5
    use: UI labels, badges
  overline:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.3px
    use: Uppercase overline labels
  code:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.32px'
    use: Inline code, terminal output (JetBrains Mono)
  code-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.28px'
    use: Code snippets, technical labels (JetBrains Mono)
rounded:
  sm: 2px
  md: 4px
  lg: 37px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 40
  section: 80
components:
  button-primary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0f0f0f'
    rounded: 4px
    padding: 8px 24px
    use: White fill, near-black text, no border
  button-cyan:
    type: button
    rounded: 4px
    use: 'Electric cyan 12% bg, 1px ocean blue #0096ff border, glow-from-within'
  button-ghost:
    type: button
    rounded: 4px
    padding: 10px
    use: 'Transparent fill, 1px signal blue #0089ff or charcoal #2c2c2c border'
  card:
    type: card
    backgroundColor: '#000000'
    rounded: 4px
    use: Pure black surface, white-opacity 4-12% border, optional brutalist shadow
  code-block:
    type: card
    backgroundColor: '#000000'
    rounded: 4px
    use: JetBrains Mono, white-opacity 10% border, syntax-highlighted
fonts:
  roles:
    sans: abcDiatype
    mono: JetBrains Mono
---

# Composio

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Composio; reproduced for educational reference. Full prose: https://oh-my-design.kr/composio/design.md

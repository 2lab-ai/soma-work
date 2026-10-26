---
name: Ecosia
colors:
  brand-primary: '#333333'
  brand-secondary: '#275243'
  featured: '#d7eb80'
  featured-hover: '#bbcf65'
  featured-active: '#a1b353'
  primary-hover: '#4c4c4c'
  primary-active: '#6c6c6c'
  secondary-hover: '#deded9'
  secondary-active: '#bebeb9'
  foreground: '#333333'
  text-secondary: '#6c6c6c'
  ink-static: '#1a1a1a'
  canvas: '#ffffff'
  background-secondary: '#f8f8f6'
  background-quaternary: '#f0f0eb'
  focus: '#0094c7'
  success: '#008009'
  leaf-dark: '#005304'
  error: '#b90a32'
  results-link: '#1a0dab'
  results-visited: '#681da8'
typography:
  display:
    fontSize: 48px
    fontWeight: 700
    use: hero heading
  body:
    fontSize: 16px
    fontWeight: 400
    use: buttons and body
rounded:
  pill: 9999px
components:
  button-featured:
    type: button
    backgroundColor: '#d7eb80'
    textColor: '#333333'
    border: '#d7eb80'
    rounded: 9999px
    height: 40px
    padding: 0 15px
    typography: 16px / 400
    hover: '#bbcf65'
    pressed: '#a1b353'
    focus: 'outline 2px solid #0094c7'
    use: Download Ecosia Browser — the featured lime pill (--color-button-background-featured-*); a 2px blue focus outline.
  button-transparent:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 9999px
    height: 40px
    padding: 0 15px
    typography: 16px / 400
    hover: rgba(51,51,51,0.16)
    pressed: rgba(51,51,51,0.24)
    focus: 'outline 2px solid #0094c7'
    use: AI tools — a transparent pill tinting 16% on hover and 24% when pressed.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Founders Grotesk
    sans: Inter
---

# Ecosia

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ecosia; reproduced for educational reference. Full prose: https://oh-my-design.kr/ecosia/design.md

---
name: n8n
colors:
  brand-pink: '#ea4b71'
  cta-from: '#fd8925'
  cta-to: '#ff0c00'
  primary-600: '#ee4f27'
  primary-400: '#f96e49'
  secondary-orange: '#ff9b26'
  button-primary-from: '#077ac7'
  button-primary: '#6b21ef'
  tertiary-from: '#a3a3a3'
  tertiary: '#bcbcbc'
  midnight-navy: '#0e0918'
  dark-navy: '#1b1728'
  deep-navy: '#1f192a'
  slate-blue: '#48556a'
  hazy-white: '#f7f6fa'
  text-primary: '#d1cece'
  text-secondary: '#9d9797'
  heading: '#ffffff'
  green: '#35a670'
typography:
  heading:
    fontSize: 48px
    fontWeight: 400
    use: section headings (--text-headline-md 48px)
  body:
    fontSize: 14px
    fontWeight: 400
    use: buttons; navigation 15px
rounded:
  md: 8px
  lg: 16px
  xl: 24px
components:
  button-cta:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 8px
    height: 40px
    padding: 0 20px
    typography: 14px / 400
    hover: rgba(255,255,255,0.12)
    pressed: rgba(255,255,255,0.12)
    use: 'Get started for free — a 30° gradient from #fd8925 to #ff0c00 (--color-button-cta-*); hover and press lay a 12% white layer over it.'
  button-glass:
    type: button
    backgroundColor: rgba(163,163,163,0.2)
    textColor: '#ffffff'
    rounded: 8px
    height: 40px
    padding: 0 20px
    typography: 14px / 400
    hover: rgba(188,188,188,0.2)
    pressed: rgba(188,188,188,0.2)
    use: 'Talk to sales — translucent grey (the tertiary pair #a3a3a3 → #bcbcbc at 20%) on the dark page.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: geomanist
---

# n8n

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to n8n; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/n8n/DESIGN.md

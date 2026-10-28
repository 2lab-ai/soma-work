---
name: MOZE
colors:
  primary: '#ff367c'
  primary-blue: '#6e86ff'
  violet: '#a963ff'
  accent-periwinkle: '#8897e3'
  accent-orange: '#f58327'
  accent-gold: '#f0c732'
  accent-green: '#4dff64'
  accent-lavender: '#bba2e0'
  canvas: '#0d0d12'
  black: '#000000'
  panel: '#1a1d31'
  panel-raised: '#323648'
  on-dark: '#ffffff'
  body: '#d0d0d0'
  muted: '#7b7c8c'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-2.08px'
    use: Hero / section headlines, Poppins
  section:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.4
    use: Sub-section heads (H3), Poppins
  plan-name:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.3
    use: Pricing plan title (H4), Poppins
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Lead / inline body copy, system sans
  nav:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.3
    use: Top-nav link, system sans
  button:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.3
    use: Pill CTA label, system sans
rounded:
  sm: 8px
  md: 20px
  lg: 40px
  full: 999px
spacing:
  xs: 1
  sm: 2
  base: 12
  md: 20
  lg: 32
  section: 64
components:
  cta-gradient:
    type: button
    textColor: '#ffffff'
    rounded: 999px
    padding: 12px 20px
    height: 41px
    typography: 12px / 400 system-sans
    backgroundColor: '#ff367c'
    states: 'pink→periwinkle gradient 274deg #6e86ff→#ff367c; orange/pink glow shadow'
    use: Primary download CTA (立即免費下載 / 立即下載)
  cta-outline:
    type: button
    textColor: '#ffffff'
    rounded: 999px
    padding: 1px
    height: 43px
    border: '1px gradient ring (orange #f58327 radial)'
    use: Secondary pill CTA (查看完整教學)
  nav-link:
    type: tab
    textColor: '#ffffff'
    typography: 12px / 400 system-sans
    padding: 2px 0px
    height: 30px
    use: Top-nav item (定價方案 / 教學文件 / 常見問題)
    active: 'white #ffffff on dark'
  plan-card-free:
    type: card
    backgroundColor: '#323648'
    rounded: 20px
    padding: 32px
    use: Free pricing tier card (基本版 $0)
  plan-card-pro:
    type: card
    backgroundColor: '#1a1d31'
    rounded: 20px
    padding: 32px
    border: '1px gradient ring (pink #ff367c → violet #a963ff)'
    use: Highlighted pro tier card (專業版 + AI), pink/blue glow shadow
  feature-card:
    type: card
    backgroundColor: '#1a1d31'
    rounded: 20px
    padding: 32px
    use: Feature / screenshot panel on canvas
  badge-accent:
    type: badge
    backgroundColor: '#ff367c'
    textColor: '#ffffff'
    rounded: 999px
    typography: 12px / 400 system-sans
    use: Highlight / emphasis pill (solid pink)
  inline-link:
    type: listItem
    textColor: '#bba2e0'
    typography: 18px / 400 system-sans
    use: Inline lavender text link (這裡)
fonts:
  roles:
    display: Poppins
    body: system sans-serif (CJK fallback)
---

# MOZE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MOZE; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/moze/DESIGN.md

---
name: Gaudiy
colors:
  ink: '#050505'
  ink-pure: '#000000'
  text: '#333333'
  muted: '#555555'
  muted-alt: '#777777'
  faint: '#656565'
  canvas: '#ffffff'
  surface: '#eeeeee'
  on-ink: '#ffffff'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-3.2px'
    use: Hero headline, Noto Sans JP Bold, tight negative tracking
  section:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 1.6px
    use: Section / label heads, Noto Sans JP Bold, positive editorial tracking
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text + links, sans-serif
  cta:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Button / link label, sans-serif
rounded:
  sm: 0px
  md: 0px
  lg: 0px
  full: 9999px
spacing:
  xs: 8
  sm: 9
  md: 10
  base: 16
  lg: 18
  xl: 32
  xxl: 64
components:
  cta-solid:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 0px
    padding: 9px
    typography: 16px / 400 sans-serif
    use: Solid black inline CTA ('くわしく見る') — black-on-white inversion, sharp 0px corners
  cta-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '2px solid #050505'
    rounded: 0px
    padding: 0px 16px
    height: 64px
    typography: 16px / 400 sans-serif
    use: Outline CTA on recruit site ('カジュアル面談に申し込む', 'コーポレートサイトへ') — heavy 2px black border, sharp corners
  news-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #000000'
    rounded: 0px
    padding: 12px 16px 10px
    use: Bordered news / press card on corporate hero (investment & partnership headlines)
  job-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '2px solid #050505'
    rounded: 0px
    padding: 8px 16px 18px
    use: Open-role card on recruit special site (プロダクトデザイナー, PdM, etc.)
  section-band:
    type: card
    backgroundColor: '#eeeeee'
    textColor: '#333333'
    rounded: 0px
    use: Full-width grey section band segmenting the long-scroll corporate page
  nav-link:
    type: tab
    textColor: '#333333'
    typography: 16px / 400 sans-serif
    use: Top nav / footer navigation item (Tech Blog, AI Lab, Member note)
    active: 'ink #050505 text on active'
  close-round:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 9999px
    use: Circular 32px close control (modal/banner) — the one round shape in an otherwise sharp system
fonts:
  roles:
    display: Noto Sans JP
    latin: Noto Sans
    fallback: sans-serif
---

# Gaudiy

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Gaudiy; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/gaudiy/DESIGN.md

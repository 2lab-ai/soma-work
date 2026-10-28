---
name: Fourdesire
colors:
  primary: '#2dd4bf'
  gradient-start: '#fbbf24'
  gradient-mid: '#a3e635'
  gradient-end: '#2dd4bf'
  ink: '#000000'
  heading: '#374151'
  strong: '#111827'
  body: '#4b5563'
  muted: '#6b7280'
  faint: '#9ca3af'
  canvas: '#ffffff'
  surface: '#f3f4f6'
  hairline: '#e5e7eb'
  panel-dark: '#1f2937'
  amber-glow: '#fffbeb'
  walkr-green: '#55b67c'
  walkr-teal: '#215468'
  walkr-teal-deep: '#00455b'
  walkr-cyan: '#a5f3fc'
  walkr-surface: '#e3efee'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0px
    use: Top hero headline, Montserrat Bold
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.11
    letterSpacing: '-0.9px'
    use: Section headline, Montserrat Bold
  feature:
    fontSize: 30px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: '-0.75px'
    use: Feature block titles, Montserrat ExtraBold
  card-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: App/feature card heads
  eyebrow:
    fontSize: 16px
    fontWeight: 800
    lineHeight: 1.5
    letterSpacing: '-0.4px'
    use: Small all-emphasis eyebrow labels
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading + nav text
  button:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.5
    use: Primary CTA pill label
  button-sm:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.5
    use: Compact Download pill label
rounded:
  sm: 8px
  md: 12px
  lg: 20px
  xl: 24px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 28
  section: 48
components:
  button-primary:
    type: button
    textColor: '#ffffff'
    rounded: 9999px
    padding: 14px 28px
    height: 56px
    typography: 18px / 600 Montserrat
    use: 'Hero CTA ''Explore SPARKFUL Apps'' — tri-color gradient #fbbf24 -> #a3e635 -> #2dd4bf, white text, full pill'
  button-download:
    type: button
    textColor: '#ffffff'
    rounded: 9999px
    padding: 12px 24px
    typography: 16px / 600 Montserrat
    use: App-page 'Download' pill — same tri-color gradient fill, white text
  button-white-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 9999px
    padding: 12px 24px
    typography: 16px / 600 Montserrat
    use: Secondary pill on colored app sections ('Explore the planets')
  nav-link:
    type: tab
    textColor: '#111827'
    typography: 16px / 400 Montserrat
    use: Top nav app/menu item; 76px-tall transparent header on white
    active: 'darkens to #000000 ink'
  card-app:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#374151'
    rounded: 12px
    use: App preview card on white; separated by tint not shadow (shadowless)
  card-surface:
    type: card
    backgroundColor: '#f3f4f6'
    textColor: '#374151'
    rounded: 20px
    use: Tinted feature panel on the gray-100 'bg-light' band
  panel-dark:
    type: card
    backgroundColor: '#1f2937'
    textColor: '#ffffff'
    rounded: 24px
    use: Dark slate phone-frame / media panel
  media-thumb:
    type: card
    backgroundColor: '#e5e7eb'
    rounded: 20px 20px 0px 0px
    use: Article/video thumbnail, top-rounded only
  footer-link:
    type: listItem
    textColor: '#111827'
    typography: 16px / 400 Montserrat
    use: Footer + app-list navigation link
fonts:
  roles:
    sans: Montserrat
    cjk-fallback: system Traditional-Chinese (PingFang TC / Noto Sans TC)
---

# Fourdesire

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Fourdesire; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/sparkful/DESIGN.md

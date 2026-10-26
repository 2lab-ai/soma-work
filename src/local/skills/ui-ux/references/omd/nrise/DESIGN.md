---
name: NRISE (WIPPY)
colors:
  primary: '#ff0056'
  ink: '#222222'
  ink-pure: '#000000'
  ink-nav: '#212429'
  neutral-900: '#212529'
  neutral-850: '#212126'
  section-dark: '#111111'
  canvas: '#ffffff'
  surface: '#fafafa'
  muted: '#767676'
  muted-alt: '#8c8c8c'
  on-dark: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.5
    use: WIPPY hero headline, Pretendard Bold
  section:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.35
    use: Corporate section titles (NRISE가 세상에 전하는 가치)
  section-sm:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.33
    use: Product section titles on the career/WIPPY surface
  subheading:
    fontSize: 23px
    fontWeight: 700
    lineHeight: 1.35
    use: Card / feature subheads
  logo:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Corporate logotype in the nav
  eyebrow:
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.5
    use: Section eyebrow labels (MISSION, HISTORY, NEWS)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body copy, news items, CTA labels
  nav:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: Top-nav item labels
rounded:
  xs: 4px
  sm: 8px
  md: 10px
  lg: 12px
  xl: 24px
  pill: 30px
  jumbo: 48px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  cta-wippy:
    type: button
    backgroundColor: '#ff0056'
    textColor: '#ffffff'
    rounded: 30px
    padding: 8px 16px
    height: 40px
    typography: 16px / 700
    use: WIPPY product CTA (더 알아보기) — the single signature pink action
  cta-dark-pill:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 30px
    padding: 8px 16px
    height: 40px
    typography: 16px / 700
    use: Second-product CTA (더 알아보기) on the corporate home
  cta-solid:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 8px
    padding: 10.5px 24px
    height: 48px
    typography: 16px / 400
    use: WIPPY career primary button (바로가기)
  nav-item:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212429'
    rounded: 4px
    padding: 5.5px 12px
    height: 32px
    typography: 14px / 600
    active: 'bg #222222 fg #ffffff'
    use: Top-nav item; active item fills dark
  floating-top:
    type: button
    backgroundColor: '#212529'
    textColor: '#ffffff'
    rounded: 24px
    height: 48px
    shadow: rgba(0,0,0,0.04) 0px 1px 2px, rgba(0,0,0,0.06) 0px 8px 24px
    use: Scroll-to-top floating action button
  news-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    use: News/press list card on white canvas
  dark-card:
    type: card
    backgroundColor: '#212126'
    textColor: '#ffffff'
    rounded: 12px
    use: Dark product feature card on the WIPPY surface
  eyebrow-tag:
    type: badge
    textColor: '#767676'
    typography: 19px / 400
    use: Section eyebrow label (MISSION, HISTORY, NEWS)
fonts:
  roles:
    sans: Pretendard
---

# NRISE (WIPPY)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NRISE (WIPPY); reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/nrise/DESIGN.md

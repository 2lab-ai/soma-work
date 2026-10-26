---
name: Wantedly
colors:
  primary: '#21bddb'
  link: '#006f8e'
  ink: '#24282a'
  gray800: '#292929'
  card-dark: '#424242'
  gray50: '#f5f5f5'
  banner: '#eeeeee'
  mid-gray: '#757575'
  canvas: '#ffffff'
  on-primary: '#ffffff'
  alert: '#cc0000'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 700
    lineHeight: 1.33
    use: Hero headline over photography, Poppins Bold, white
  section:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.4
    use: Section headlines, Poppins Bold
  h1-quiet:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.5
    use: Page H1, regular weight (visual hierarchy carried by hero H2)
  button:
    fontSize: 16px
    fontWeight: 600
    use: Pill button labels, Poppins SemiBold
  button-sm:
    fontSize: 14px
    fontWeight: 600
    use: Small pill buttons / SSO buttons, Poppins SemiBold
  nav-label:
    fontSize: 14px
    fontWeight: 600
    letterSpacing: 0.2px
    use: Uppercase nav labels on wantedly.design
  input:
    fontSize: 16px
    fontWeight: 400
    use: Form inputs, Lato
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Standard reading text, Helvetica Neue / Hiragino Sans
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  xl: 24px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 40
  section: 72
components:
  button-primary:
    type: button
    backgroundColor: '#21bddb'
    textColor: '#ffffff'
    rounded: 28px
    height: 56px
    typography: 16px / 400 Poppins
    use: Signup / submit CTA — full pill on the brand blue
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: rgba(0,0,0,0.56)
    rounded: 48px
    height: 52px
    padding: 0 16px
    typography: 16px / 600 Poppins
    shadow: rgba(0,0,0,0.1) 0px 2px 6px
    use: White pill (今すぐシゴトを検索, SSO sign-in)
  input-text:
    type: input
    backgroundColor: rgba(0,0,0,0.06)
    textColor: rgba(0,0,0,0.84)
    rounded: 4px
    height: 40px
    padding: 6px 12px
    typography: 16px / 400 Lato
    use: Email signup field — tinted fill, no border
  card-elevated:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    shadow: rgba(0,0,0,0.15) 0px 2px 8px
    use: Floating banner card
  panel-tint:
    type: card
    backgroundColor: rgba(0,0,0,0.06)
    rounded: 16px
    padding: 20px 24px
    use: App-download promo panel on white
  banner-recruiter:
    type: card
    backgroundColor: '#eeeeee'
    rounded: 24px
    padding: 40px 80px 32px
    use: Recruiter-facing wide banner
  card-dark:
    type: card
    backgroundColor: '#424242'
    textColor: '#ffffff'
    rounded: 4px
    use: Article card on the wantedly.design gray800 canvas
  link-teal:
    type: tab
    textColor: '#006f8e'
    active: 'text #24282a'
    typography: 14px / 400 Poppins
    use: Text links and nav items — dark teal, darkens to ink on active
fonts:
  roles:
    latin-display: ITC Avant Garde Gothic → Poppins
    latin-body: Lato / Helvetica Neue
    japanese: Tazugane Gothic → Hiragino Kaku Gothic ProN → Noto Sans CJK
---

# Wantedly

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wantedly; reproduced for educational reference. Full prose: https://oh-my-design.kr/wantedly/design.md

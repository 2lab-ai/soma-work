---
name: Snapchat
colors:
  primary: '#FFFC00'
  primary-text: '#000000'
  interactive: '#0096E5'
  ink: '#121314'
  ink-dark: '#000000'
  body: '#53575B'
  muted: '#C7C7CC'
  surface-dark: '#3A3E41'
  canvas: '#FFFFFF'
  surface-grey: '#F0F1F2'
  on-primary: '#000000'
typography:
  display-hero:
    fontSize: 44px
    fontWeight: 400
    lineHeight: 1.2
    use: Hero mission headline (snap.com), Inter/Ghost Sans
  section:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.3
    use: Section headings, Avenir Next Bold
  body:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Standard body text, Avenir Next Medium
  nav:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Nav links, Ghost Sans Medium
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: CTA label, Ghost Sans Medium
  caption:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.5
    use: Nav label under icons, Avenir Next SemiBold
rounded:
  sm: 5px
  md: 8px
  lg: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#FFFC00'
    textColor: '#000000'
    rounded: 64px
    padding: 11px 31px
    typography: 16px / 500 Ghost Sans
    use: Primary CTA on business/marketing surface — Get Started, See Ad Formats
  button-dark:
    type: button
    backgroundColor: '#000000'
    textColor: '#FFFFFF'
    rounded: 64px
    padding: 11px 31px
    typography: 16px / 500 Ghost Sans
    use: Secondary CTA on dark canvas
  button-login:
    type: button
    backgroundColor: '#0096E5'
    textColor: '#FFFFFF'
    rounded: 100px
    padding: 12px 20px
    typography: 14px / 500 Avenir Next
    use: Log In CTA on snapchat.com web app
  input-search:
    type: input
    backgroundColor: '#F0F1F2'
    textColor: '#53575B'
    rounded: 20px
    padding: 10px 30px 10px 40px
    typography: 12px / 700 Arial
    use: Search input on web app
  input-text:
    type: input
    backgroundColor: rgba(0,0,0,0.05)
    textColor: '#121314'
    rounded: 5px
    padding: 7px
    typography: 16px / 500 Arial
    use: Login form text input
  card-dark:
    type: card
    backgroundColor: '#3A3E41'
    textColor: '#C7C7CC'
    rounded: 8px
    padding: 16px
    use: Dark content card on business surface (newsletter, blog)
  card-light:
    type: card
    backgroundColor: '#FFFFFF'
    textColor: '#121314'
    rounded: 8px
    padding: 16px
    use: Light content card with soft border
  badge-yellow:
    type: badge
    backgroundColor: '#FFFC00'
    textColor: '#000000'
    rounded: 9999px
    use: Yellow emphasis pill / feature tag
  nav-item:
    type: tab
    textColor: '#C7C7CC'
    typography: 16px / 500 Ghost Sans
    use: Business nav links
    active: 'text #FFFC00 on active'
  avatar-circle:
    type: avatar
    rounded: 50%
    use: User avatar / ghost icon container, circular
fonts:
  roles:
    display: Ghost Sans
    body: Avenir Next
    fallback: Helvetica, Tahoma, Arial, sans-serif
---

# Snapchat

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Snapchat; reproduced for educational reference. Full prose: https://oh-my-design.kr/snapchat/design.md

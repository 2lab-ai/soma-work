---
name: BBC
colors:
  primary: '#000000'
  brand-red: '#bb1919'
  brand-red-dark: '#b80000'
  brand-red-bright: '#eb0000'
  canvas: '#ffffff'
  surface: '#f6f6f6'
  surface-alt: '#f8f8f8'
  heading: '#202224'
  body: '#3a3c3e'
  muted: '#545658'
  hairline: '#e6e8ea'
  on-primary: '#ffffff'
  gel-heading: '#3a3c3e'
typography:
  display-hero:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.25
    use: Hero article headline, Reith Sans Bold
  heading-md:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.25
    use: Section heading, GEL H1 at 20px/700
  nav-link:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.5
    use: Global nav primary links, BBC Reith Sans
  nav-active:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    use: Active/selected nav section, bold
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body copy, minimum 15-18px per GEL spec
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1
    use: CTA button label, BBC Reith Sans
  caption:
    fontSize: 13px
    fontWeight: 400
    use: Captions, metadata, GEL Brevier scale
rounded:
  sm: 0px
  md: 0px
  lg: 0px
  full: 0px
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
  button-register:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 0px
    padding: 6px 12px
    border: '2px solid #000000'
    typography: 16px / 500 BBC Reith Sans
    use: Register CTA — primary black block button
  button-sign-in:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 6px 12px
    border: 2px solid transparent
    typography: 16px / 500 BBC Reith Sans
    use: Sign In — ghost/outline button variant
  input-search:
    type: input
    backgroundColor: rgba(239,239,239,0.3)
    textColor: '#202224'
    rounded: 0px
    padding: 13px 0px 13px 13px
    border: none
    typography: BBC Reith Sans
    use: Global search input — flat frosted background, no border
  nav-tab:
    type: tab
    textColor: '#000000'
    typography: 14px / 500 BBC Reith Sans
    active: 'text #000000 font-weight 700'
    use: Global nav item; active section bold 700
  card-article:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#202224'
    rounded: 0px
    use: Article teaser card — flat white, no shadow, no radius, relies on spacing + typography
  card-surface:
    type: card
    backgroundColor: '#f6f6f6'
    textColor: '#202224'
    rounded: 0px
    use: 'Grey surface content section — flat #f6f6f6 background panel'
  badge-live:
    type: badge
    backgroundColor: '#bb1919'
    textColor: '#ffffff'
    rounded: 0px
    padding: 2px 6px
    typography: 12px / 700 BBC Reith Sans
    use: LIVE badge on breaking news / video — red block, no radius
  toggle-dark-mode:
    type: toggle
    textColor: '#000000'
    use: Account/preference toggle in user settings
fonts:
  roles:
    sans: BBC Reith Sans
    serif: BBC Reith Serif
    legacy: Arial, Helvetica, freesans, sans-serif
---

# BBC

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to BBC; reproduced for educational reference. Full prose: https://oh-my-design.kr/bbc/design.md

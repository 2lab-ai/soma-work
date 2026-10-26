---
name: Accupass
colors:
  primary: '#00aaf5'
  brand: '#0088d2'
  cta-header: '#2ab3fc'
  cta-pill: '#009ce6'
  gradient-start: '#3e97d3'
  gradient-end: '#1074cc'
  link-organizer: '#2ea3f2'
  accent-pink: '#ff93c2'
  pink-surface: '#ffeef3'
  canvas: '#ffffff'
  surface: '#f8fbff'
  ink: '#212121'
  heading: '#333333'
  body: '#757575'
  muted: '#959ba1'
  faint: '#b5bac1'
  hairline: '#d8dde4'
  footer-dark: '#1a1f23'
  footer-subtitle: '#6d7278'
  on-dark: '#f5faff'
  on-primary: '#ffffff'
typography:
  event-title:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.5
    use: Event detail H1
  section:
    fontSize: 23px
    fontWeight: 600
    lineHeight: 1.5
    use: Homepage section H2 (Weekly recommend, Popular Events)
  footer-head:
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.33
    use: Footer column subtitles
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Default body, nav, buttons, tags
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Event meta rows, calendar link
rounded:
  xs: 3px
  sm: 4px
  md: 8px
  lg: 16px
  pill: 22px
  full: 100px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  xl: 24
  xxl: 48
components:
  button-create-event:
    type: button
    backgroundColor: '#2ab3fc'
    textColor: '#ffffff'
    rounded: 3px
    padding: 6px 11px
    height: 31px
    typography: 14px / 400 Noto Sans
    use: Header 'Create Event' CTA — organizer entry point
  button-register:
    type: button
    backgroundColor: '#1074cc'
    textColor: '#ffffff'
    rounded: 4px
    padding: 16px
    height: 50px
    typography: 14px / 600 Noto Sans
    use: 'Event-page ''Register Now'' — rendered as linear-gradient #3e97d3 → #1074cc'
  button-more:
    type: button
    backgroundColor: '#009ce6'
    textColor: '#ffffff'
    rounded: 22px
    padding: 12px 48px
    height: 38px
    typography: 14px / 700 Noto Sans
    use: Section 'More' pill on homepage
  button-service:
    type: button
    backgroundColor: '#00aaf5'
    textColor: '#f5faff'
    rounded: 8px
    padding: 8px
    height: 36px
    typography: 14px / 400 Noto Sans
    use: Footer 'Ask ACCUPASS' support button
  badge-category-blue:
    type: badge
    backgroundColor: '#00aaf5'
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px 16px
    typography: 14px / 400 Noto Sans
    shadow: rgba(0,170,245,0.3) 0px 2px 4px
    use: Event category tag (Learning)
  badge-category-pink:
    type: badge
    backgroundColor: '#ff93c2'
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px 16px
    typography: 14px / 400 Noto Sans
    use: Event type tag (Offline Event)
  badge-keyword-chip:
    type: badge
    textColor: '#959ba1'
    border: '1px solid #d8dde4'
    rounded: 100px
    padding: 8px 16px
    typography: 14px / 400 Noto Sans
    use: Outlined keyword chips on event page (設計系統, UIUX)
  card-event:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: rgba(0,0,0,0.1) 0px 2px 8px
    use: Homepage event card; image caps top corners 16px 16px 0 0
  nav-tab:
    type: tab
    active: 'text #0088d2'
    disabled: '#b5bac1 label'
    typography: 14px / 600 Noto Sans
    use: Homepage channel tabs (Featured Events / Learning / Art / Experience)
fonts:
  roles:
    sans: Noto Sans
    fallback: Microsoft JhengHei
---

# Accupass

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Accupass; reproduced for educational reference. Full prose: https://oh-my-design.kr/accupass/design.md

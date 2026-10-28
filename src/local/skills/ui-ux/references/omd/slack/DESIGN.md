---
name: Slack
colors:
  primary: '#4A154B'
  primary-hover: '#611F69'
  primary-active: '#7C3085'
  brand: '#4A154B'
  canvas: '#FFFFFF'
  foreground: '#1D1C1D'
  body: '#616061'
  muted: '#868686'
  on-primary: '#FFFFFF'
  cta-green: '#007A5A'
  cta-green-hover: '#148567'
  link: '#1264A3'
  error: '#E01E5A'
  warning: '#ECB22E'
  success: '#2BAC76'
  accent-blue: '#36C5F0'
  accent-green: '#2EB67D'
  accent-yellow: '#ECB22E'
  surface: '#F8F8F8'
  hairline: '#E8E8E8'
  sidebar: '#3F0E40'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 900
    lineHeight: 1.14
    letterSpacing: '-0.02px'
    use: Marketing hero headlines (Larsseit)
  display-lg:
    fontSize: 44px
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: '-0.01px'
    use: Section headers (web)
  heading-1:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Page titles
  heading-2:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Sub-sections, modal titles
  heading-3:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    use: Card titles, channel headers
  subtitle:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: List headers, emphasized labels
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Marketing body, descriptions
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.46
    use: Message text — the workhorse
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Secondary info, metadata
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Timestamps, fine print
  code:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Inline code, code blocks (Monaco)
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#007A5A'
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 0 16px
    height: 44px
    typography: 18px / 900
    hover: '#148567'
    use: Primary marketing CTA
  button-aubergine:
    type: button
    backgroundColor: '#4A154B'
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 0 16px
    typography: 18px / 900
    hover: '#611F69'
    use: Brand-forward CTA on white
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#4A154B'
    border: '1px solid #4A154B'
    rounded: 4px
    padding: 0 16px
    typography: 18px / 700
    hover: 8% aubergine tint fill
    use: Secondary marketing action
  button-product:
    type: button
    backgroundColor: '#007A5A'
    textColor: '#FFFFFF'
    border: 1px solid transparent
    rounded: 4px
    padding: 0 12px
    height: 36px
    typography: 15px / 900
    hover: '#148567'
    use: In-app confirm (Send, Create channel)
  button-danger:
    type: button
    backgroundColor: '#E01E5A'
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 0 12px
    typography: 15px / 900
    hover: darken 8%
    disabled: opacity 0.5
    use: Destructive confirm
  input:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: '#1D1C1D'
    border: 1px solid rgba(29,28,29,0.3)
    rounded: 4px
    padding: 11px 12px
    typography: 15px / 400
    focus: 'border #1264A3 + 0 0 0 1px #1264A3'
    use: Standard form input
  composer:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: '#1D1C1D'
    border: 1px solid rgba(29,28,29,0.3)
    rounded: 8px
    padding: 8px 12px
    typography: 15px / 400
    focus: border rgba(29,28,29,0.5), inner shadow
    use: Message composer
  card:
    type: card
    backgroundColor: '#FFFFFF'
    border: '1px solid #E8E8E8'
    rounded: 8px
    padding: 24px
    shadow: 0 1px 3px rgba(0,0,0,0.08)
    use: Content panels, feature cards
  badge-unread:
    type: badge
    backgroundColor: '#CD2553'
    textColor: '#FFFFFF'
    rounded: 9999px
    padding: 1px 6px
    typography: 12px / 700
    use: Channel/DM unread count
  badge-status:
    type: badge
    backgroundColor: '#F8F8F8'
    textColor: '#616061'
    border: '1px solid #E8E8E8'
    rounded: 12px
    padding: 2px 10px
    typography: 13px / 700
    use: NEW, custom status, app labels
  tab-sidebar:
    type: tab
    backgroundColor: transparent
    textColor: rgba(255,255,255,0.7)
    active: 'bg #1164A3, text #FFFFFF'
    hover: bg rgba(255,255,255,0.1)
    typography: 15px / 700
    use: Channel list in sidebar
  tab-segmented:
    type: tab
    backgroundColor: transparent
    textColor: '#616061'
    active: 'text #1D1C1D, 2px bottom border #4A154B'
    typography: 15px / 700
    use: Threads/Mentions/Saved switching
  toast:
    type: toast
    backgroundColor: '#1D1C1D'
    textColor: '#FFFFFF'
    rounded: 8px
    padding: 12px 16px
    shadow: 0 4px 12px rgba(0,0,0,0.2)
    typography: 15px / 400
    use: Transient confirmation
  banner:
    type: card
    backgroundColor: '#FEF7E0'
    textColor: '#1D1C1D'
    border: '3px solid #ECB22E'
    rounded: 4px
    padding: 12px 16px
    use: System notice, workspace announcement
  dialog:
    type: dialog
    backgroundColor: '#FFFFFF'
    textColor: '#1D1C1D'
    rounded: 8px
    padding: 24px
    shadow: 0 18px 48px rgba(0,0,0,0.35)
    use: Create-channel, preferences, confirmation
  toggle:
    type: toggle
    backgroundColor: '#868686'
    rounded: 9999px
    states: 'on #007A5A'
    use: Boolean settings; white thumb
fonts:
  roles:
    sans: Lato
    mono: Monaco
---

# Slack

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Slack; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/slack/DESIGN.md

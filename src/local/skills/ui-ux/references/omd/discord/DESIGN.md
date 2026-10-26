---
name: Discord
colors:
  primary: '#5865F2'
  primary-hover: '#4752C4'
  primary-active: '#3C45A5'
  green: '#57F287'
  yellow: '#FEE75C'
  fuchsia: '#EB459E'
  red: '#ED4245'
  surface-tertiary: '#1E1F22'
  surface-secondary: '#2B2D31'
  surface-primary: '#313338'
  surface-floating: '#111214'
  text-normal: '#DBDEE1'
  heading: '#F2F3F5'
  muted: '#949BA4'
  interactive: '#B5BAC1'
  link: '#00A8FC'
  grey-secondary: '#4E5058'
  message-box: '#383A40'
  on-primary: '#FFFFFF'
typography:
  hero:
    fontSize: 56px
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: '-0.02px'
    use: Marketing hero headline
  display-lg:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.01px'
    use: Modal titles, big moments
  h1:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
    use: Section headers
  h2:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    use: Sub-sections, settings groups
  channel:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.25
    use: Channel/server headers
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.375
    use: Message text, descriptions
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.29
    use: Standard UI text, list items
  label:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0.02px
    use: Section labels UPPERCASE
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Timestamps, helper text
  code:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.29
    use: Inline code, code blocks (gg mono)
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 40
components:
  button-primary:
    type: button
    backgroundColor: '#5865F2'
    textColor: '#FFFFFF'
    rounded: 8px
    padding: 2px 16px
    typography: 14px/500 gg sans
    use: Primary action — Send, Confirm, Join
  button-secondary:
    type: button
    backgroundColor: '#4E5058'
    textColor: '#FFFFFF'
    rounded: 8px
    padding: 2px 16px
    typography: 14px/500 gg sans
    use: Neutral secondary action
  button-link:
    type: button
    backgroundColor: transparent
    textColor: '#FFFFFF'
    padding: 2px 4px
    typography: 14px/500 gg sans
    use: Tertiary action, subtle cancel
  input:
    type: input
    backgroundColor: '#1E1F22'
    textColor: '#DBDEE1'
    rounded: 4px
    padding: 10px 12px
    typography: 16px/400 gg sans
    use: Settings forms, search, login
  message-box:
    type: input
    backgroundColor: '#383A40'
    textColor: '#DBDEE1'
    rounded: 8px
    padding: 11px 16px
    typography: 16px/400 gg sans
    use: Chat composer
  embed-card:
    type: card
    backgroundColor: '#2B2D31'
    rounded: 4px
    padding: 16px
    use: Rich link previews, bot responses (4px left accent)
  settings-card:
    type: card
    backgroundColor: '#2B2D31'
    rounded: 8px
    padding: 16px 20px
    use: Grouped settings rows
  modal:
    type: dialog
    backgroundColor: '#313338'
    rounded: 8px
    padding: 16px
    use: Confirmation dialogs, server settings
  mention-badge:
    type: badge
    backgroundColor: '#ED4245'
    textColor: '#FFFFFF'
    rounded: 9999px
    padding: 0 4px
    typography: 12px/700 gg sans
    use: Unread mention counter
  nitro-badge:
    type: badge
    backgroundColor: '#5865F2'
    textColor: '#FFFFFF'
    rounded: 4px
    typography: 12px/600 gg sans
    use: Nitro / boosted badge
  settings-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#B5BAC1'
    rounded: 4px
    padding: 6px 10px
    typography: 16px/500 gg sans
    active: 'bg #404249, text #FFFFFF'
    use: Settings sidebar item
  tooltip:
    type: card
    backgroundColor: '#111214'
    textColor: '#F2F3F5'
    rounded: 8px
    padding: 8px 12px
    typography: 14px/600 gg sans
    use: Hover hints on icons
  toast:
    type: toast
    backgroundColor: '#111214'
    textColor: '#DBDEE1'
    rounded: 8px
    padding: 12px 16px
    use: Transient confirmations (4px left status accent)
  toggle:
    type: toggle
    backgroundColor: '#57F287'
    rounded: 9999px
    use: 'Boolean settings — track green on, #80848E off'
fonts:
  roles:
    sans: gg sans
    mono: gg mono
---

# Discord

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Discord; reproduced for educational reference. Full prose: https://oh-my-design.kr/discord/design.md

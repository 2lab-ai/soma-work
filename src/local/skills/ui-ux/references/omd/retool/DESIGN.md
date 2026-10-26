---
name: Retool
colors:
  cod-gray: '#1a1a1a'
  ink-black: '#0e0e0e'
  green-white: '#e9ebdf'
  white: '#ffffff'
  burnt-sienna: '#e0613a'
  burnt-sienna-hover: '#c94f2c'
  cornflower: '#6e8be0'
  smalt-blue: '#4e7c82'
  action-primary: '#3c3c3c'
  success: '#2fa86a'
  error: '#e5484d'
  warning: '#e0a23a'
  panel: '#232323'
  border-dark: '#2e2e2e'
  muted: '#6b6b6b'
  caption: '#8a8a8a'
  body-dark: '#b4b4b4'
  strong-dark: '#d6d6d6'
  light-100: '#f4f5ef'
  light-200: '#dcded2'
  light-border: '#cacbbf'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.07
    letterSpacing: '-0.02em'
    use: Marketing hero headlines
  display:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.02em'
    use: Section headers
  h1:
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.27
    letterSpacing: '-0.01em'
    use: Page titles
  h2:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.36
    letterSpacing: '-0.01em'
    use: Card / feature titles
  h3:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.44
    use: Sub-sections, panel headers
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Standard UI text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Metadata, table headers
  label:
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: 0.06em
    use: Uppercase eyebrows, column heads
  code:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.54
    use: Query editor, values, keys (IBM Plex Mono)
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
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
  button-primary:
    type: button
    backgroundColor: '#3c3c3c'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0 16px
    typography: 14/500
    use: Default primary action on light (Save, Run)
  button-accent:
    type: button
    backgroundColor: '#e0613a'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0 18px
    typography: 15/600
    use: Top-of-funnel CTA (Start for free)
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#d6d6d6'
    rounded: 6px
    padding: 0 16px
    typography: 14/500
    use: 'Outline secondary, 1px #3c3c3c border on dark'
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#b4b4b4'
    rounded: 6px
    padding: 0 10px
    typography: 14/500
    use: Toolbar/inline tertiary actions
  button-destructive:
    type: button
    backgroundColor: '#e5484d'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0 16px
    typography: 14/500
    use: Delete query, destructive confirmation
  input-light:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 6px
    padding: 8px 12px
    typography: 14/400
    use: 'Standard form input on light, #e0613a focus'
  input-dark:
    type: input
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 6px
    padding: 8px 12px
    typography: 14/400
    use: Inspector/builder forms on dark canvas
  code-editor:
    type: input
    backgroundColor: '#0e0e0e'
    textColor: '#d6d6d6'
    rounded: 6px
    padding: 12px
    typography: 13/400
    use: 'SQL/JS query editor, 1px #2e2e2e border'
  card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 8px
    padding: 20px
    use: 'Marketing feature cards, 1px #cacbbf border'
  panel-dark:
    type: card
    backgroundColor: '#232323'
    textColor: '#d6d6d6'
    rounded: 8px
    padding: 16px
    use: 'Inspector, component tray, 1px #2e2e2e border'
  badge-success:
    type: badge
    backgroundColor: rgba(47,168,106,0.14)
    textColor: '#2fa86a'
    rounded: 4px
    padding: 2px 8px
    typography: 12/600
    use: Deployed, Connected, Passing
  badge-error:
    type: badge
    backgroundColor: rgba(229,72,77,0.14)
    textColor: '#e5484d'
    rounded: 4px
    padding: 2px 8px
    typography: 12/600
    use: Failed, Disconnected
  badge-warning:
    type: badge
    backgroundColor: rgba(224,162,58,0.14)
    textColor: '#e0a23a'
    rounded: 4px
    padding: 2px 8px
    typography: 12/600
    use: Unsaved, Deprecated
  badge-neutral:
    type: badge
    backgroundColor: '#2e2e2e'
    textColor: '#b4b4b4'
    rounded: 4px
    padding: 2px 8px
    typography: 12/500
    use: Environment tags, version labels
  tab:
    type: tab
    textColor: '#8a8a8a'
    typography: 14/500
    padding: 10px 14px
    use: Builder panels (Query/State/Logs)
    active: '#ffffff text + 2px #e0613a bottom indicator'
  toast:
    type: toast
    backgroundColor: '#232323'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    typography: 14/400
    use: Query/save confirmation, leading status dot
  dialog:
    type: dialog
    backgroundColor: '#1a1a1a'
    textColor: '#b4b4b4'
    rounded: 10px
    padding: 24px
    use: 'Confirmations, resource setup, 1px #2e2e2e border'
  toggle:
    type: toggle
    backgroundColor: '#3c3c3c'
    textColor: '#ffffff'
    rounded: 9999px
    use: Feature flags, env switches; on=#e0613a, white thumb
fonts:
  roles:
    sans: Inter
    mono: IBM Plex Mono
---

# Retool

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Retool; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/retool/DESIGN.md

---
name: Perplexity
colors:
  primary: '#20808d'
  primary-hover: '#1a6873'
  primary-deep: '#13343b'
  primary-tint: '#e5f2f2'
  teal-on-dark: '#34b4c4'
  ink: '#091717'
  canvas: '#fbfaf4'
  surface: '#fcfcf9'
  surface-white: '#ffffff'
  body: '#2e3a3a'
  muted: '#5c6a6a'
  placeholder: '#8a9494'
  hairline: '#e4e4dc'
  hairline-soft: '#efefe9'
  dark-canvas: '#0d1117'
  dark-surface: '#161b22'
  dark-line: '#2a2f37'
  ink-inverse: '#f2f2ed'
  success: '#1f9d6b'
  error: '#e0524a'
  warning: '#d9923a'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: '-0.02px'
    use: Landing hero
  display:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.17
    letterSpacing: '-0.02px'
    use: Marketing section headers
  heading-lg:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.29
    letterSpacing: '-0.01px'
    use: Thread title, page headers
  heading:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.36
    letterSpacing: '-0.01px'
    use: Answer section headers, modal titles
  subtitle:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.44
    use: Source group labels, card headings
  answer-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: Generated answer text, reading-first leading
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    use: UI descriptions, settings
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Buttons, tabs, chips
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Metadata, source domains, timestamps
  mono:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.54
    use: Code, model IDs
rounded:
  sm: 6px
  md: 10px
  lg: 16px
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
    backgroundColor: '#20808d'
    textColor: '#ffffff'
    rounded: 10px
    padding: 0 18px
    typography: 14px / 500
    use: Ask / submit primary CTA
  button-secondary:
    type: button
    backgroundColor: '#fcfcf9'
    textColor: '#091717'
    rounded: 10px
    padding: 0 18px
    typography: 14px / 500
    use: 'Secondary action, 1px #e4e4dc border'
  button-ghost:
    type: button
    backgroundColor: '#efefe9'
    textColor: '#5c6a6a'
    rounded: 8px
    padding: 0 12px
    typography: 14px / 500
    use: Toolbar actions (Share, Sources, More)
  pill:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#2e3a3a'
    rounded: 9999px
    padding: 6px 14px
    typography: 13px / 500
    use: Focus mode / filter selector
    active: '#20808d border, #13343b text, #e5f2f2 bg'
  composer:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#091717'
    rounded: 16px
    padding: 16px 18px
    typography: 16px / 400
    use: 'The Ask box, 1px #e4e4dc border, focus #20808d ring'
  text-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#091717'
    rounded: 10px
    padding: 10px 14px
    typography: 15px / 400
    use: 'Standard text field, 1px #e4e4dc border'
  answer-card:
    type: card
    backgroundColor: '#fcfcf9'
    rounded: 12px
    padding: 20px 24px
    use: 'Generated answer block, 1px #efefe9 border, editorial flat'
  source-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    padding: 12px 14px
    use: 'Cited source card, 1px #e4e4dc border'
  citation-chip:
    type: badge
    backgroundColor: '#e5f2f2'
    textColor: '#13343b'
    rounded: 6px
    padding: 1px 6px
    typography: 11px / 600
    use: Inline source reference
  badge-pro:
    type: badge
    backgroundColor: '#13343b'
    textColor: '#ffffff'
    rounded: 6px
    padding: 2px 8px
    typography: 11px / 600
    use: PRO / model labels
  badge-status:
    type: badge
    backgroundColor: '#e5f2f2'
    textColor: '#20808d'
    rounded: 6px
    padding: 2px 8px
    typography: 11px / 600
    use: New / Beta / focus-mode labels
  tab:
    type: tab
    textColor: '#5c6a6a'
    typography: 14px / 500
    use: Home / Discover / Spaces / Library
    active: '#091717 text, 2px bottom border #20808d'
  toast:
    type: toast
    backgroundColor: '#091717'
    textColor: '#f2f2ed'
    rounded: 10px
    padding: 12px 16px
    typography: 14px / 400
    use: Copied / Shared transient confirmations
  dialog:
    type: dialog
    backgroundColor: '#fbfaf4'
    textColor: '#091717'
    rounded: 16px
    padding: 28px
    use: Sign-in, settings, share, upgrade modal
  toggle:
    type: toggle
    backgroundColor: '#20808d'
    rounded: 9999px
    use: 'Settings switch, #ffffff thumb'
fonts:
  roles:
    sans: FK Grotesk
    mono: Berkeley Mono
---

# Perplexity

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Perplexity; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/perplexity/DESIGN.md

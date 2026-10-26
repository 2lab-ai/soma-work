---
name: BOOTH
colors:
  brand: '#fc4d50'
  brand-hover: '#ce2f36'
  brand-press: '#9b1e25'
  primary: '#2c9ba6'
  primary-hover: '#067a87'
  primary-press: '#145c69'
  link: '#1b7f8c'
  link-press: '#0f6270'
  foreground: '#171d26'
  text-body: '#252f3d'
  canvas: '#ffffff'
  background-secondary: '#f1f5f8'
  background-tertiary: '#dee4e9'
  input: '#ebedf2'
  input-border: '#d5d9de'
  focus-soft: '#94dee2'
  notice: '#fed63d'
  positive: '#2f92db'
  negative: '#ce2f36'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: search field and links, system stack
rounded:
  sm: 5px
components:
  link-notice:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1b7f8c'
    rounded: 0px
    height: 32px
    typography: 14px / 600
    pressed: 'fg #0f6270'
    use: 'お知らせ一覧 — a teal link button with a hairline inset bottom; hover changes nothing, press and focus darken the label to #0f6270.'
    padding: 4px 16px
    focus: 'label #0f6270, browser default focus ring (outline auto) (+4 nested-layer changes) on :focus-visible'
  input-search:
    type: input
    backgroundColor: '#ebedf2'
    textColor: '#171d26'
    border: '#d5d9de'
    rounded: 5px
    height: 32px
    typography: 16px / 400
    hover: '#ebedf2'
    focus: '#ffffff + border #171d26'
    use: The header keyword field (キーワードを入力) — grey fill that turns white with a dark border on focus; no hover change.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: booth heavy
---

# BOOTH

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to BOOTH; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/booth/DESIGN.md

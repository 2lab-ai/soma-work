---
name: Thumbtack Thumbprint
colors:
  primary: '#009fd9'
  canvas: '#ffffff'
  foreground: '#2f3033'
  muted: '#676d73'
  hairline: '#e9eced'
typography:
  display:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.1
    use: Observed h1 on the public button documentation route
  heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.333
    use: Observed h2 on the public button documentation route
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Repeated body and documentation list content on the supplied public surfaces
  label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Repeated navigation, list, and search-input text on the supplied public surfaces
rounded:
  square: 0px
  control: 4px
  pill: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 32
components:
  docs-primary-button:
    type: button
    backgroundColor: '#07344a'
    textColor: '#7cdcfd'
    border: 1px solid transparent
    rounded: 9999px
    padding: 0px 24px
    height: 48px
    typography: 16px / 700 Rise
    states: Default and a separate disabled specimen were captured; no hover, focus, pressed, or interaction transition was captured.
    use: Public Button v2 documentation primary example; selector surface-2::[data-omd-capture=63]
  global-search:
    type: input
    backgroundColor: transparent
    textColor: '#2f3033'
    rounded: 4px
    padding: 9px 16px 9px 12px
    height: 38px
    typography: 14px / 400 Rise
    states: Default only; no focus, error, disabled, or input interaction was captured.
    use: Public Thumbprint navigation search combobox; selector home::[data-omd-capture=1]
  documentation-list-item:
    type: listItem
    textColor: '#2f3033'
    border: '1px solid #e9eced (top only)'
    padding: 24px 0px
    typography: 16px / 400 Rise
    use: Public component-documentation content row; selector surface-2::li
fonts:
  roles:
    ui: Rise
---

# Thumbtack Thumbprint

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Thumbtack Thumbprint; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/thumbtack/DESIGN.md

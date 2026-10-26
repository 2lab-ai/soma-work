---
name: Pega UX Design System
colors:
  header: '#1a3a5c'
  action: '#03102e'
  canvas: '#ffffff'
  foreground: '#050505'
  accent: '#0b6dd3'
  accent-weak: '#e8f3fb'
typography:
  heading:
    fontSize: 38.4px
    fontWeight: 500
    lineHeight: 48px
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24.64px
rounded:
  version-button: 2px
  dark-action: 32px
  search-input: 0px
spacing:
  version-button-y: 6
  version-button-x: 12
  search-input-x: 12
  dark-action-y: 16
  dark-action-x: 32
components:
  dark-link-action:
    type: button
    backgroundColor: '#03102e'
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 32px
    height: 59px
    padding: 16px 32px
    typography: 16px / 700 / Roboto Flex
    states: default observed only; interaction capture reported 0
    use: design.pega.com documentation-site home action (link-as-button class) — not a Pega UX Design System component
    pressed: 'bg #ffffff, label #000000, shadow #ffffff 0px 0px 0px 1.76px, #076bc9 0px 0px 0px 2.88px, rgba(7, 107, 201, 0.1) 0px 0px 0px 4.8px (:hover + :active)'
  header-search:
    type: input
    backgroundColor: rgba(255, 255, 255, 0.14)
    textColor: '#ffffff'
    rounded: 0px
    height: 32px
    padding: 0px 12px
    typography: 14px / 400 / Roboto Flex
    states: default observed only; interaction capture reported 0
    use: design.pega.com documentation-site masthead search field — not a Pega UX Design System component
  menu-row:
    type: listItem
    textColor: '#050505'
    height: 42px
    typography: 16px / 400 / Roboto Flex
    use: design.pega.com documentation-site navigation row — not a Pega UX Design System component
fonts:
  roles:
    ui: Roboto Flex
---

# Pega UX Design System

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Pega UX Design System; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/pega/DESIGN.md

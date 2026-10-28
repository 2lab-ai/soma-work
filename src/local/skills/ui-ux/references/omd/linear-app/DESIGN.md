---
name: Linear
colors:
  primary: '#5e6ad2'
  canvas: '#08090a'
  foreground: '#f7f8f8'
  secondary: '#d0d6e0'
  muted: '#8a8f98'
  quiet: '#62666d'
  primary-action: '#e5e5e6'
  on-primary-action: '#08090a'
  hairline: '#1c1d1e'
typography:
  display:
    fontSize: 48px
    fontWeight: 510
    lineHeight: 1
    letterSpacing: '-1.056px'
    use: Repeated public section display heading
  heading:
    fontSize: 24px
    fontWeight: 590
    lineHeight: 1.33
    letterSpacing: '-0.288px'
    use: Public feature and card heading
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.165px'
    use: Method and public descriptive body
  navigation:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.13px'
    use: Public navigation and compact product-preview labels
  mono:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    use: Embedded public product-preview technical input
rounded:
  product-control: 6px
  card: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 24
  xl: 32
components:
  primary-action:
    type: button
    backgroundColor: '#e5e5e6'
    textColor: '#08090a'
    border: '1px solid #e5e5e6'
    rounded: 9999px
    padding: 0 20px
    height: 44px
    typography: 16px / 510
    hover: '#ffffff'
    pressed: '#ffffff'
    states: hover and pressed re-measured live 2026-09-17 and share one value — the pill brightens to white; keyboard focus produces no visible change. Compact 32px variant remains local
    use: Highest-priority public get-started action
    focus: 'outline #5e69d1 solid 1px on :focus-visible'
  secondary-action:
    type: button
    backgroundColor: rgba(255,255,255,0.05)
    textColor: '#f7f8f8'
    rounded: 9999px
    padding: 0 20px
    height: 44px
    typography: 16px / 510
    states: default captured; no universal hover token promoted
    use: Paired public contact-sales action
  nav-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#8a8f98'
    rounded: 9999px
    padding: 0 12px
    height: 32px
    typography: 13px / 400
    states: focus, hover, pressed, expanded, and menu-open observed across current routes
    use: Current public navigation trigger
  product-menu-item:
    type: tab
    backgroundColor: transparent
    textColor: '#f7f8f8'
    rounded: 8px
    padding: 12px 16px 12px 12px
    typography: 16px / 400
    states: selected, expanded, and menu-open captured in the embedded product preview
    use: Current embedded product-preview menu row
  customer-card:
    type: card
    backgroundColor: transparent
    textColor: '#f7f8f8'
    rounded: 8px
    padding: 24px 32px
    use: Large current customer-story card; lime sibling remains a surface-local editorial variant
fonts:
  roles:
    ui: Inter
    mono: Berkeley Mono
  faces:
    Inter:
      scripts:
        - latin
      evidence:
        - official-product-use
        - live-surface-use
      source: https://rsms.me/inter/
      licence: OFL-1.1
      distribution: public
      note: Captured as Inter Variable; Linear serves the public Inter 4.1 file unmodified.
    Berkeley Mono:
      scripts:
        - latin
      evidence:
        - official-product-use
        - live-surface-use
      source: https://usgraphics.com/static/products/TX-02/datasheet/TX-02-datasheet.a43c0c7f8d8c.pdf
      licence: Proprietary and non-transferrable
      distribution: none-asserted
      note: U.S. Graphics TX-02; linear.app loads a variable build (Berkeley Mono Variable).
      substitutes:
        latin:
          family: Fira Code
          provider: google
          label: substitute — not the brand face
---

# Linear

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Linear; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/linear.app/DESIGN.md
